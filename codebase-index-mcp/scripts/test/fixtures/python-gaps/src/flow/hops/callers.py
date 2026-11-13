from ..staging import Ctx
from ..steps.draft_step import DraftStep
from ..steps.fix_step import FixStep
from .apply import apply_step, kw_trap, relay


def fix_now(ctx: Ctx):
    return apply_step(FixStep(), ctx)


def draft_later(ctx: Ctx):
    return relay(DraftStep(), ctx)


def kw_caller(ctx: Ctx):
    from ..steps.draft_step import Worker

    return kw_trap(ctx, Worker(), Worker(), step=FixStep())
