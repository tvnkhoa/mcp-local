from .a_sinks.ports import Sink


def send_int(sink: Sink) -> None:
    sink.emit(1)
