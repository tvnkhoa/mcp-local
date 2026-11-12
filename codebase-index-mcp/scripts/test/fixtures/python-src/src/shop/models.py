from dataclasses import dataclass
from typing import Protocol

from pydantic import BaseModel, field_validator


class Item(BaseModel):
    name: str
    cents: int

    @field_validator("cents")
    @classmethod
    def non_negative(cls, value: int) -> int:
        return value


class PricePort(Protocol):
    def quote(self, item: Item) -> int: ...


@dataclass
class Base:
    label: str

    def describe(self) -> str:
        return self.label
