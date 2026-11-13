"""PY-6b: a test's own double must not become a type of production code's untyped parameter."""
from flow.hops.apply import apply_step


class FakeStep:
    def run(self, ctx):
        return None


def test_apply_with_double():
    apply_step(FakeStep(), None)
