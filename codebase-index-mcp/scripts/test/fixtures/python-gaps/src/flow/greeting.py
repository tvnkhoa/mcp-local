"""Review fixes: a Protocol default method reached through a subclass; a generic Protocol."""
from typing import Protocol, TypeVar

T = TypeVar("T")


class Greeter(Protocol):
    def greet(self) -> str:
        return "hi"


class Loud(Greeter):
    def shout(self) -> str:
        return self.greet().upper()


class Box(Protocol[T]):
    def put(self, item: T) -> None: ...


class IntBox:
    """Structural: `item: int` fits the Protocol's `item: T`."""

    def put(self, item: int) -> None:
        pass
