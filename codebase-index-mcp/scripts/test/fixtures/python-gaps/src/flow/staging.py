"""PY-6 fixture: a Protocol port, as translate's core/ports.py Stage."""
from typing import ClassVar, Protocol


class Ctx:
    pass


class Outcome:
    pass


class Step(Protocol):
    name: ClassVar[str]

    def run(self, ctx: Ctx) -> Outcome: ...
