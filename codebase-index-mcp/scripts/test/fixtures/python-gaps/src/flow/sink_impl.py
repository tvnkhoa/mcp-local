"""ISSUE-128 leftover 8: an explicit Protocol subclass EXTENDS the Protocol it imports (z_sinks, not a_sinks)."""
from .z_sinks.ports import Sink


class LoudSink(Sink):
    def emit(self, text: str) -> None:
        pass
