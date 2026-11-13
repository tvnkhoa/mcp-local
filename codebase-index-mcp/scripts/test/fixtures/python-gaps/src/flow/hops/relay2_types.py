"""Review #1: the receivers' classes, in their own file so the anchors below bind cross-file (flagged)."""
from .relay2_ping import Pinger


class GoA:
    def go(self, x) -> None:
        x.ping()


class GoB:
    def go(self, x) -> None:
        x.ping()


__all__ = ["GoA", "GoB", "Pinger"]
