from ..ports import Executor


class ManualExecutor(Executor):
    """Explicit: lists the Protocol as a base."""

    def run(self, job: str) -> str:
        return job.upper()

    def close(self) -> None:
        pass
