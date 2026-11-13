"""PY-5c: a Sink Protocol that sorts FIRST by path — the decoy for callers importing z_sinks."""
from typing import Protocol


class Sink(Protocol):
    def emit(self, value: int) -> None: ...


class IntSink:
    def emit(self, value: int) -> None:
        pass
