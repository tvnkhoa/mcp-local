class BatchRunner:
    """Structural for BatchExecutor, and so for Executor too."""

    def run(self, job: str) -> str:
        return job

    def close(self) -> None:
        pass

    def run_batch(self, jobs: list[str]) -> list[str]:
        return [self.run(j) for j in jobs]
