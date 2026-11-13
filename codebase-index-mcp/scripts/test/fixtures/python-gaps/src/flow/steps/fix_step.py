from ..staging import Ctx, Outcome


class FixStep:
    name = "S7"

    def run(self, ctx: Ctx) -> Outcome:
        return Outcome()
