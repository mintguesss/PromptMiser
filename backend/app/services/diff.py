import re
from difflib import SequenceMatcher
from typing import List

from ..models.schemas import DiffSegment

# 中文逐字、英數字整詞、空白整段，其餘符號單顆——diff 粒度才會自然
_TOKEN_RE = re.compile(r"\s+|[一-鿿]|[A-Za-z0-9_]+|.", re.S)


def _tokenize(text: str) -> List[str]:
    return _TOKEN_RE.findall(text)


def compute_diff(before: str, after: str) -> List[DiffSegment]:
    """字詞層級的 before/after diff，回傳 keep / delete / add 片段（相鄰同型別已合併）"""
    a, b = _tokenize(before), _tokenize(after)
    matcher = SequenceMatcher(a=a, b=b, autojunk=False)

    segments: List[DiffSegment] = []

    def push(seg_type: str, text: str) -> None:
        if not text:
            return
        if segments and segments[-1].type == seg_type:
            segments[-1].text += text
        else:
            segments.append(DiffSegment(type=seg_type, text=text))

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            push("keep", "".join(a[i1:i2]))
        elif tag == "delete":
            push("delete", "".join(a[i1:i2]))
        elif tag == "insert":
            push("add", "".join(b[j1:j2]))
        else:  # replace
            push("delete", "".join(a[i1:i2]))
            push("add", "".join(b[j1:j2]))

    return segments
