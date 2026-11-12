from fastapi import APIRouter

router = APIRouter()


@router.get("/items")
@router.get("/items")
@router.post("/items")
def items():
    return []
