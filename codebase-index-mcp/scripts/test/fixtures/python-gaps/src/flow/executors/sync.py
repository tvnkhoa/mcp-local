from .base import BaseExec


class SyncExecutor(BaseExec):
    """Structural: run here, close inherited from BaseExec."""

    def run(self, job: str) -> str:
        return job
