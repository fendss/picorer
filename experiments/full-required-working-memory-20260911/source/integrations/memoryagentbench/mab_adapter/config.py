from __future__ import annotations

from dataclasses import dataclass


SYSTEM_PROMPT = (
    "You are a helpful assistant that can read the context and memorize it "
    "for future retrieval."
)


@dataclass(frozen=True)
class TaskConfig:
    task_id: str
    capability: str
    split: str
    file_key: str
    source: str
    expected_contexts: int
    expected_questions: int
    chunk_tokens: int
    generation_max_tokens: int
    official_metric: str
    official_config: str
    memorize_template: str
    query_template: str

    def format_query(self, question: str) -> str:
        return self.query_template.format(question=question)

    def format_memory(self, context: str, timestamp: str) -> str:
        return self.memorize_template.format(context=context, time_stamp=timestamp)


ICL_MEMORIZE_TEMPLATE = (
    "Dialogue between User and Assistant {time_stamp} \\n<User> The "
    "following context is the examples I have learned: \n{context}\n "
    "<Assistant> I have learned the examples and I will answer the "
    "question you ask."
)
ICL_QUERY_TEMPLATE = (
    "Search Archival Memory and use the provided mapping from the "
    "context to numerical label to assign a numerical label to the "
    "context. Only output \"label: {label}\" and nothing else. "
    "\n\n{question} \n\n label:"
).replace("{label}", "{{label}}")
FACT_MEMORIZE_TEMPLATE = (
    "Dialogue between User and Assistant {time_stamp} \\n<User> The "
    "following context is the facts I have learned: \n{context}\n "
    "<Assistant> I have learned the facts and I will answer the "
    "question you ask."
)
FACT_QUERY_TEMPLATE = (
    "Pretend you are a knowledge management system. Each fact in the  "
    "Archival Memory is provided with a serial number at the beginning, "
    "and the newer fact has larger serial number. \n You need to solve "
    "the conflicts of facts in the Archival Memory by finding the newest "
    "fact with larger serial number. You need to answer a question based "
    "on this rule. You should give a very concise answer without saying "
    "other words for the question **only** from the knowledge pool you "
    "have memorized rather than the real facts in real world. "
    "\n\nFor example:\n\n [Archival Memory] \n\n Question: Based on "
    "the Archival Memory, what is the name of the current president of "
    "Russia? \nAnswer: Donald Trump \n\n Now Answer the Question: Based "
    "on the  Archival Memory, {question} \nAnswer:"
)


TASKS: dict[str, TaskConfig] = {
    "ruler-qa1": TaskConfig(
        task_id="ruler-qa1",
        capability="accurate_retrieval",
        split="Accurate_Retrieval",
        file_key="accurate_retrieval",
        source="ruler_qa1_197K",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=50,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Accurate_Retrieval/Ruler/QA/Ruler_qa1_197k.yaml",
        memorize_template=(
            "Dialogue between User and Assistant {time_stamp}\\n<User> The "
            "following context is the documents I have read: \n{context}\n "
            "<Assistant> I have learned the documents and I will answer the "
            "question you ask."
        ),
        query_template=(
            "Search Archival Memory and answer my question. Only give me the "
            "answer and do not output any other words. \n\nQuestion: "
            "{question} \n\n Answer:"
        ),
    ),
    "longmemeval-s": TaskConfig(
        task_id="longmemeval-s",
        capability="accurate_retrieval",
        split="Accurate_Retrieval",
        file_key="accurate_retrieval",
        source="longmemeval_s*",
        expected_contexts=5,
        expected_questions=300,
        chunk_tokens=4096,
        generation_max_tokens=50,
        official_metric="llm_judge",
        official_config="configs/data_conf/Accurate_Retrieval/LongMemEval/Longmemeval_s_star.yaml",
        memorize_template=(
            "Dialogue between User and Assistant \\n<User> The following context "
            "is the conversation between the user and the assistant: \n{context}\n "
            "<Assistant> I have memorized the conversation and I will answer "
            "the question you ask."
        ),
        query_template=(
            "Search Archival Memory and answer the question as concisely as "
            "you can, using a single phrase if possible.\n\n {question} "
            "\n\n Answer:"
        ),
    ),
    "trec-coarse": TaskConfig(
        task_id="trec-coarse",
        capability="test_time_learning",
        split="Test_Time_Learning",
        file_key="test_time_learning",
        source="icl_trec_coarse_6600shot_balance",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=20,
        official_metric="exact_match",
        official_config="configs/data_conf/Test_Time_Learning/ICL/ICL_trec_coarse.yaml",
        memorize_template=ICL_MEMORIZE_TEMPLATE,
        query_template=ICL_QUERY_TEMPLATE,
    ),
    "trec-fine": TaskConfig(
        task_id="trec-fine",
        capability="test_time_learning",
        split="Test_Time_Learning",
        file_key="test_time_learning",
        source="icl_trec_fine_6400shot_balance",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=20,
        official_metric="exact_match",
        official_config="configs/data_conf/Test_Time_Learning/ICL/ICL_trec_fine.yaml",
        memorize_template=ICL_MEMORIZE_TEMPLATE,
        query_template=ICL_QUERY_TEMPLATE,
    ),
    "banking77": TaskConfig(
        task_id="banking77",
        capability="test_time_learning",
        split="Test_Time_Learning",
        file_key="test_time_learning",
        source="icl_banking77_5900shot_balance",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=20,
        official_metric="exact_match",
        official_config="configs/data_conf/Test_Time_Learning/ICL/ICL_banking77.yaml",
        memorize_template=ICL_MEMORIZE_TEMPLATE,
        query_template=ICL_QUERY_TEMPLATE,
    ),
    "nlu": TaskConfig(
        task_id="nlu",
        capability="test_time_learning",
        split="Test_Time_Learning",
        file_key="test_time_learning",
        source="icl_nlu_8296shot_balance",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=20,
        official_metric="exact_match",
        official_config="configs/data_conf/Test_Time_Learning/ICL/ICL_nlu.yaml",
        memorize_template=ICL_MEMORIZE_TEMPLATE,
        query_template=ICL_QUERY_TEMPLATE,
    ),
    "clinic150": TaskConfig(
        task_id="clinic150",
        capability="test_time_learning",
        split="Test_Time_Learning",
        file_key="test_time_learning",
        source="icl_clinic150_7050shot_balance",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=20,
        official_metric="exact_match",
        official_config="configs/data_conf/Test_Time_Learning/ICL/ICL_clinic150.yaml",
        memorize_template=ICL_MEMORIZE_TEMPLATE,
        query_template=ICL_QUERY_TEMPLATE,
    ),
    "fact-sh-6k": TaskConfig(
        task_id="fact-sh-6k",
        capability="conflict_resolution",
        split="Conflict_Resolution",
        file_key="conflict_resolution",
        source="factconsolidation_sh_6k",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=10,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml",
        memorize_template=FACT_MEMORIZE_TEMPLATE,
        query_template=FACT_QUERY_TEMPLATE,
    ),
    "fact-mh-6k": TaskConfig(
        task_id="fact-mh-6k",
        capability="conflict_resolution",
        split="Conflict_Resolution",
        file_key="conflict_resolution",
        source="factconsolidation_mh_6k",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=10,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Conflict_Resolution/Factconsolidation_mh_6k.yaml",
        memorize_template=FACT_MEMORIZE_TEMPLATE,
        query_template=FACT_QUERY_TEMPLATE,
    ),
    "fact-sh-262k": TaskConfig(
        task_id="fact-sh-262k",
        capability="conflict_resolution",
        split="Conflict_Resolution",
        file_key="conflict_resolution",
        source="factconsolidation_sh_262k",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=10,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Conflict_Resolution/Factconsolidation_sh_262k.yaml",
        memorize_template=FACT_MEMORIZE_TEMPLATE,
        query_template=FACT_QUERY_TEMPLATE,
    ),
    "fact-mh-262k": TaskConfig(
        task_id="fact-mh-262k",
        capability="conflict_resolution",
        split="Conflict_Resolution",
        file_key="conflict_resolution",
        source="factconsolidation_mh_262k",
        expected_contexts=1,
        expected_questions=100,
        chunk_tokens=4096,
        generation_max_tokens=10,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Conflict_Resolution/Factconsolidation_mh_262k.yaml",
        memorize_template=FACT_MEMORIZE_TEMPLATE,
        query_template=FACT_QUERY_TEMPLATE,
    ),
    "eventqa-64k": TaskConfig(
        task_id="eventqa-64k",
        capability="accurate_retrieval",
        split="Accurate_Retrieval",
        file_key="accurate_retrieval",
        source="eventqa_65536",
        expected_contexts=5,
        expected_questions=500,
        chunk_tokens=4096,
        generation_max_tokens=40,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Accurate_Retrieval/EventQA/Eventqa_64k.yaml",
        memorize_template=(
            "Dialogue between User and Assistant {time_stamp}\\n<User> The "
            "following context is the book excerpt: \n{context}\n <Assistant> "
            "I have read the book excerpt and I will answer the question you ask."
        ),
        query_template=(
            "Search Archival Memory, complete the task below:\n\n{question}"
            "\n\n The event that happens next is:"
        ),
    ),
    "eventqa-full": TaskConfig(
        task_id="eventqa-full",
        capability="accurate_retrieval",
        split="Accurate_Retrieval",
        file_key="accurate_retrieval",
        source="eventqa_full",
        expected_contexts=5,
        expected_questions=500,
        chunk_tokens=4096,
        generation_max_tokens=40,
        official_metric="substring_exact_match",
        official_config="configs/data_conf/Accurate_Retrieval/EventQA/Eventqa_full.yaml",
        memorize_template=(
            "Dialogue between User and Assistant {time_stamp}\\n<User> The "
            "following context is the book excerpt: \n{context}\n <Assistant> "
            "I have read the book excerpt and I will answer the question you ask."
        ),
        query_template=(
            "Search Archival Memory, complete the task below:\n\n{question}"
            "\n\n The event that happens next is:"
        ),
    ),
}


def task_config(task_id: str) -> TaskConfig:
    try:
        return TASKS[task_id]
    except KeyError as error:
        raise ValueError(
            f"Unknown task {task_id!r}; choose from {', '.join(TASKS)}"
        ) from error
