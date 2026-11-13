"""Review #3: a typed and an untyped receiver reach the same method from one caller — one row, not two."""
from .relay2_ping import Pinger


def both(p: Pinger, q) -> None:
    p.ping()
    q.ping()
