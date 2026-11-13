"""PY-5c: a second Protocol named Sink, in another package."""
from typing import Protocol


class Sink(Protocol):
    def emit(self, text: str) -> None: ...


class TextSink:
    def emit(self, text: str) -> None:
        pass
