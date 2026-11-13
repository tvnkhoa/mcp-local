from ..staging import Ctx, Outcome


class DraftStep:
    name = "S4"

    def run(self, ctx: Ctx) -> Outcome:
        return Outcome()


class Worker:
    """Has a `run`, but not a Step's: a name match alone must not make it one."""

    def run(self, job: str) -> str:
        return job
