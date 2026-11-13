"""Row #16 item 3: the MCP-ISSUE-128 repro in ONE file — `x.ping()` / `r.go(...)` must not bind same-file at 0.9."""


class GoS:
    def go(self, x) -> None:
        x.ping()

    def again(self) -> None:
        self.go(None)


class PingerS:
    def ping(self) -> None:
        pass


def helper() -> None:
    pass


def drive_s(r) -> None:
    r.go(PingerS())
    helper()


def main_s() -> None:
    drive_s(GoS())


class GoT:
    def go(self, y) -> None:
        """No caller types `y`: the name pick stays flagged, even though PingerS.ping is in this file."""
        y.ping()


class Clock:
    def tick(self) -> None:
        pass


def tick() -> None:
    """Same name as Clock.tick, defined after it: c.tick() keeps extraction's first-in-file target (Clock.tick)."""


def use_tick(c) -> None:
    c.tick()
