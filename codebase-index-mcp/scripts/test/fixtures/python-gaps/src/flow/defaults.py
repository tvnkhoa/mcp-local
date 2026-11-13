"""PY-5b: a call through a Protocol reaches the body an implementer inherits."""
from typing import Protocol


class Renderer(Protocol):
    def render(self) -> str: ...

    def footer(self) -> str: ...


class RendererDefaults(Renderer, Protocol):
    """A sub-Protocol giving footer a default body."""

    def footer(self) -> str:
        return "--"


class Page(RendererDefaults):
    """Explicit; does not override footer, so it runs RendererDefaults.footer."""

    def render(self) -> str:
        return "page"


class Fancy(RendererDefaults):
    """Overrides footer: its own runs, the default is not its target."""

    def render(self) -> str:
        return "fancy"

    def footer(self) -> str:
        return "~~"


class Stray:
    """Not an implementer (no render): its footer is never a dispatch target."""

    def footer(self) -> str:
        return "stray"


def finish(r: Renderer) -> str:
    return r.footer()
