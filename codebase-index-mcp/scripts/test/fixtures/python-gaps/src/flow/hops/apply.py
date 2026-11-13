"""PY-6b: untyped parameters typed only by callers in another file, one and two hops away."""


def apply_step(step, ctx):
    return step.run(ctx)


def relay(step, ctx):
    """Untyped too: hands its own parameter on to apply_step."""
    return apply_step(step, ctx)


def poke(widget):
    """No caller types `widget`: the candidate set is every method named blink (two of them)."""
    widget.blink()
