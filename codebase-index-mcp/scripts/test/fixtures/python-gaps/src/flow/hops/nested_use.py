"""ISSUE-128: `Box.Item(x)` with Box IMPORTED binds the class nested in Box (the call pass, not the extractor)."""
from .lights import Lamp
from .nested_box import Box


def build_box():
    return Box.Item(Lamp())
