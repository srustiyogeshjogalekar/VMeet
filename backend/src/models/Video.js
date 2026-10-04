from pydantic import BaseModel

from models.common import UtcDatetime

class VideoOut(BaseModel):
    id: str
    title: str
    description: str = ""
    category: str = "general"
    thumbnail_url: str = ""
    video_url: str = ""
    file_size: int = 0
    duration: int = 0
    min_plan: str = "free"
    created_at: UtcDatetime | None = None