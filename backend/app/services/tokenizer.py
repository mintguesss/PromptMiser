import re
from functools import lru_cache

import tiktoken

_MARKER_RE = re.compile(r"\[\[([\s\S]*?)\]\]")


@lru_cache(maxsize=1)
def _encoding() -> "tiktoken.Encoding":
    return tiktoken.get_encoding("o200k_base")


def strip_protection_markers(text: str) -> str:
    """移除 [[ ]] 標記本身、保留內容——token 數以實際會送出的文字為準"""
    return _MARKER_RE.sub(r"\1", text)


def count_tokens(text: str) -> int:
    if not text:
        return 0
    return len(_encoding().encode(text))
