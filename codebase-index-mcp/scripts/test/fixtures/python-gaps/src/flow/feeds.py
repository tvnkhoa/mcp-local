"""ISSUE-128 leftover 6: an implementer fits a Protocol with a WIDER parameter and a NARROWER return."""
from typing import Protocol

from .feeds_types import Food, Meat, Steak, Stone


class Feeder(Protocol):
    def feed(self, item: Meat) -> Meat: ...


class WideFeeder:
    """item: Food is wider than Meat, -> Steak narrower: fits."""

    def feed(self, item: Food) -> Steak:
        return Steak()


class NarrowFeeder:
    """item: Steak is narrower than Meat: a Feeder caller may pass any Meat — no fit."""

    def feed(self, item: Steak) -> Meat:
        return Meat()


class WideReturnFeeder:
    """-> Food is wider than Meat: no fit."""

    def feed(self, item: Meat) -> Food:
        return Food()


class StoneFeeder:
    """Stone is unrelated to Meat: no fit."""

    def feed(self, item: Stone) -> Meat:
        return Meat()


def serve(feeder: Feeder) -> None:
    feeder.feed(Meat())
