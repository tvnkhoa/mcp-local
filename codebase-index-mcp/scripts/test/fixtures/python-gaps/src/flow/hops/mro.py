"""Review #4: Python's MRO is C3, not breadth-first. D's MRO is D, B, A, C: d.m() runs A.m."""


class A:
    def m(self) -> str:
        return "A"


class C:
    def m(self) -> str:
        return "C"


class B(A):
    pass


class D(B, C):
    pass


def use_mro() -> str:
    d = D()
    return d.m()
