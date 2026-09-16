from __future__ import annotations


def chunk_text(text: str, max_tokens: int = 4096) -> list[str]:
    """Match MemoryAgentBench's sentence-preserving GPT token chunking."""
    if max_tokens < 1:
        raise ValueError("max_tokens must be positive")
    try:
        import nltk
        import tiktoken
    except ImportError as error:
        raise RuntimeError("nltk and tiktoken are required; install requirements.txt") from error
    try:
        sentences = nltk.sent_tokenize(text)
    except LookupError as error:
        raise RuntimeError(
            "NLTK punkt data is missing; run: python -m nltk.downloader punkt_tab"
        ) from error
    encoding = tiktoken.encoding_for_model("gpt-4o-mini")
    chunks: list[str] = []
    current: list[str] = []
    token_count = 0
    for sentence in sentences:
        sentence_count = len(
            encoding.encode(sentence, allowed_special={"<|endoftext|>"})
        )
        if token_count + sentence_count > max_tokens:
            chunks.append(" ".join(current))
            current = [sentence]
            token_count = sentence_count
        else:
            current.append(sentence)
            token_count += sentence_count
    if current:
        chunks.append(" ".join(current))
    if not chunks:
        raise ValueError("Context produced no chunks")
    return chunks
