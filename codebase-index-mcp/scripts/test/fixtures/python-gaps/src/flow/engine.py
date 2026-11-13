"""PY-6 fixture: untyped receivers, as translate's core/pipeline.py run path."""
from typing import Callable

from .staging import Ctx, Step
from .steps.fix_step import FixStep

StepFactory = Callable[[], Step]


def make_fix() -> Step:
    return FixStep()


class Engine:
    def factory(self, step_id: str) -> StepFactory:
        return make_fix

    def go(self, ctx: Ctx) -> None:
        for sid in ["S7"]:
            self.factory(sid)().run(ctx)

    def built(self, ctx: Ctx) -> None:
        step = make_fix()
        step.run(ctx)

    def direct(self, ctx: Ctx) -> None:
        helper = FixStep()
        self.drive(helper, ctx)

    def drive(self, item, ctx):
        item.run(ctx)


def with_default(ctx, step=FixStep()):
    step.run(ctx)


def unknown(thing, ctx):
    thing.run(ctx)
