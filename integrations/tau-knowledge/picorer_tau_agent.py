"""Thin tau2 HalfDuplexAgent adapter for the Picorer JSONL bridge.

The official tau2 environment remains the sole owner of user simulation,
domain-tool execution, database state, and evaluation. This adapter only
translates messages and tool schemas; it never executes benchmark tools.
"""

from __future__ import annotations

import json
import math
import os
import selectors
import subprocess
from dataclasses import dataclass
from typing import Any, Optional

from tau2.agent.base_agent import HalfDuplexAgent
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from tau2.environment.tool import Tool


BRIDGE_ARGS_ENV = "PICORER_TAU_BRIDGE_ARGS"
BRIDGE_RESPONSE_TIMEOUT_ENV = "PICORER_TAU_BRIDGE_RESPONSE_TIMEOUT_SECONDS"
DEFAULT_BRIDGE_RESPONSE_TIMEOUT_SECONDS = 930.0
DEFAULT_FIRST_AGENT_MESSAGE = "Hi! How can I help you today?"


@dataclass
class PicorerTauState:
    turns: int = 0


class PicorerBridgeError(RuntimeError):
    pass


class PicorerBridge:
    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        initial_assistant_message: str,
    ):
        serialized_args = os.environ.get(BRIDGE_ARGS_ENV)
        if not serialized_args:
            raise PicorerBridgeError(f"{BRIDGE_ARGS_ENV} is not configured")
        try:
            args = json.loads(serialized_args)
        except json.JSONDecodeError as error:
            raise PicorerBridgeError(f"{BRIDGE_ARGS_ENV} is invalid JSON") from error
        if not isinstance(args, list) or not args or not all(
            isinstance(item, str) and item for item in args
        ):
            raise PicorerBridgeError(f"{BRIDGE_ARGS_ENV} must be a JSON string array")
        raw_timeout = os.environ.get(BRIDGE_RESPONSE_TIMEOUT_ENV)
        try:
            self._response_timeout = (
                DEFAULT_BRIDGE_RESPONSE_TIMEOUT_SECONDS
                if raw_timeout is None
                else float(raw_timeout)
            )
        except ValueError as error:
            raise PicorerBridgeError(
                f"{BRIDGE_RESPONSE_TIMEOUT_ENV} must be a number"
            ) from error
        if not math.isfinite(self._response_timeout) or not (
            1 <= self._response_timeout <= 1800
        ):
            raise PicorerBridgeError(
                f"{BRIDGE_RESPONSE_TIMEOUT_ENV} must be between 1 and 1800 seconds"
            )
        self._process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        self._pending_tool_names: dict[str, str] = {}
        definitions = []
        for tool in tools:
            function = tool.openai_schema.get("function")
            if not isinstance(function, dict):
                raise PicorerBridgeError(f"tau2 tool {tool.name} has no function schema")
            parameters = function.get("parameters")
            if not isinstance(parameters, dict):
                raise PicorerBridgeError(f"tau2 tool {tool.name} has no parameter schema")
            definitions.append(
                {
                    "name": tool.name,
                    "description": str(function.get("description") or tool.name),
                    "parameters": parameters,
                }
            )
        ready = self.request(
            {
                "type": "initialize",
                "domainPolicy": domain_policy,
                "tools": definitions,
                "initialAssistantMessage": initial_assistant_message,
            }
        )
        if ready.get("type") != "ready":
            raise PicorerBridgeError("Picorer bridge did not acknowledge initialization")
        self.identity = ready

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._process.stdin is None or self._process.stdout is None:
            raise PicorerBridgeError("Picorer bridge pipes are unavailable")
        if self._process.poll() is not None:
            raise PicorerBridgeError(
                f"Picorer bridge exited with code {self._process.returncode}"
            )
        self._process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._process.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self._process.stdout, selectors.EVENT_READ)
            readable = selector.select(self._response_timeout)
        if not readable:
            self.close()
            raise PicorerBridgeError(
                "Picorer bridge response exceeded "
                f"{self._response_timeout:g} seconds"
            )
        line = self._process.stdout.readline()
        if not line:
            self.close()
            raise PicorerBridgeError("Picorer bridge closed without a response")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise PicorerBridgeError("Picorer bridge returned invalid JSON") from error
        if not isinstance(response, dict):
            raise PicorerBridgeError("Picorer bridge response must be an object")
        if response.get("type") == "error":
            message = str(response.get("message") or "bridge error")
            self.close()
            raise PicorerBridgeError(message)
        return response

    def input_for(self, message: Message) -> dict[str, Any]:
        if isinstance(message, UserMessage):
            return {"type": "user", "content": message.content or ""}
        tool_messages: list[ToolMessage]
        if isinstance(message, ToolMessage):
            tool_messages = [message]
        elif isinstance(message, MultiToolMessage):
            tool_messages = message.tool_messages
        else:
            raise PicorerBridgeError(
                f"Unsupported tau2 input message: {type(message).__name__}"
            )
        results = []
        for tool_message in tool_messages:
            tool_name = self._pending_tool_names.get(tool_message.id)
            if tool_name is None:
                raise PicorerBridgeError(
                    f"Unknown pending tau2 tool call: {tool_message.id}"
                )
            results.append(
                {
                    "toolCallId": tool_message.id,
                    "toolName": tool_name,
                    "content": tool_message.content or "",
                    "isError": tool_message.error,
                }
            )
        return {"type": "tool-results", "results": results}

    def assistant_for(self, response: dict[str, Any]) -> AssistantMessage:
        if response.get("type") != "assistant":
            raise PicorerBridgeError("Picorer bridge response is not an assistant turn")
        raw_calls = response.get("toolCalls")
        if not isinstance(raw_calls, list):
            raise PicorerBridgeError("Picorer bridge assistant has no tool-call list")
        tool_calls: list[ToolCall] = []
        next_pending: dict[str, str] = {}
        for index, raw_call in enumerate(raw_calls):
            if not isinstance(raw_call, dict):
                raise PicorerBridgeError(f"Invalid bridge tool call at index {index}")
            call_id = raw_call.get("id")
            name = raw_call.get("name")
            arguments = raw_call.get("arguments")
            if (
                not isinstance(call_id, str)
                or not isinstance(name, str)
                or not isinstance(arguments, dict)
            ):
                raise PicorerBridgeError(f"Invalid bridge tool call at index {index}")
            tool_calls.append(
                ToolCall(
                    id=call_id,
                    name=name,
                    arguments=arguments,
                    requestor="assistant",
                )
            )
            next_pending[call_id] = name
        self._pending_tool_names = next_pending
        content = response.get("content")
        if content is not None and not isinstance(content, str):
            raise PicorerBridgeError("Picorer bridge assistant content is invalid")
        usage = response.get("usage")
        cost: Optional[float] = None
        if isinstance(usage, dict):
            raw_cost = usage.get("cost")
            if isinstance(raw_cost, dict) and isinstance(raw_cost.get("total"), (int, float)):
                cost = float(raw_cost["total"])
        return AssistantMessage(
            role="assistant",
            content=None if tool_calls else (content or ""),
            tool_calls=tool_calls or None,
            usage=usage if isinstance(usage, dict) else None,
            cost=cost,
            raw_data={
                "picorer": response.get("audit"),
                "model": response.get("model"),
                "picorer_runtime": self.identity,
            },
        )

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        if self._process.stdin is not None:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()


class PicorerTauAgent(HalfDuplexAgent[PicorerTauState]):
    def __init__(self, tools: list[Tool], domain_policy: str):
        super().__init__(tools=tools, domain_policy=domain_policy)
        self._bridge: Optional[PicorerBridge] = None

    def get_init_state(
        self, message_history: Optional[list[Message]] = None
    ) -> PicorerTauState:
        history = message_history or []
        if (
            len(history) != 1
            or not isinstance(history[0], AssistantMessage)
            or history[0].is_tool_call()
            or history[0].content != DEFAULT_FIRST_AGENT_MESSAGE
        ):
            raise PicorerBridgeError(
                "Pinned tau-Knowledge tasks must start with the official default "
                "assistant greeting"
            )
        if self._bridge is not None:
            raise PicorerBridgeError("Picorer tau agent was initialized more than once")
        self._bridge = PicorerBridge(
            self.tools,
            self.domain_policy,
            DEFAULT_FIRST_AGENT_MESSAGE,
        )
        return PicorerTauState()

    def generate_next_message(
        self, message: Message, state: PicorerTauState
    ) -> tuple[AssistantMessage, PicorerTauState]:
        if self._bridge is None:
            raise PicorerBridgeError("Picorer tau agent is not initialized")
        response = self._bridge.request(self._bridge.input_for(message))
        state.turns += 1
        return self._bridge.assistant_for(response), state

    def stop(
        self,
        message: Optional[Message] = None,
        state: Optional[PicorerTauState] = None,
    ) -> None:
        if self._bridge is not None:
            self._bridge.close()


def create_picorer_tau_agent(tools, domain_policy, **_kwargs):
    return PicorerTauAgent(tools=tools, domain_policy=domain_policy)
