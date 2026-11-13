"""PY-5c: each caller binds the Sink it imports."""
from .z_sinks.ports import Sink


def send(sink: Sink) -> None:
    sink.emit("x")
