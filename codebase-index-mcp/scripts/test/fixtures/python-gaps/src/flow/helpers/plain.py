"""PY-8b: no __all__ — a star import binds the public names only (own and imported)."""
from .priv import _private


def shown() -> int:
    return 1


def _hidden() -> int:
    return 0
