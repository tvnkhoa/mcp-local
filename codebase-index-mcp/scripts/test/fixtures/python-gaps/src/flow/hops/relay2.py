"""Review #1: an anchor that also carries pyargs (`r.go(Pinger())` on an untyped `r`)."""
from .relay2_ping import Pinger


def drive2(r) -> None:
    r.go(Pinger())
