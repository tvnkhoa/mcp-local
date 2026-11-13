"""PY-5 fixture: Protocol ports."""
from typing import Protocol

import typing_extensions


class Executor(Protocol):
    name: str

    def run(self, job: str) -> str: ...

    def close(self) -> None: ...


class BatchExecutor(Executor, Protocol):
    def run_batch(self, jobs: list[str]) -> list[str]: ...


class Named(typing_extensions.Protocol):
    """Attributes only: no structural implementer, or every class would match."""

    name: str


class Store:
    """An ordinary class: stays kind class."""

    def close(self) -> None:
        pass
