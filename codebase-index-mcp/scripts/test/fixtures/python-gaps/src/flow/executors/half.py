class HalfExecutor:
    """run without close: not an Executor."""

    def run(self, job: str) -> str:
        return job
