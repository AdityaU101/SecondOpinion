"""
Profile routes — family health profiles under one account.

DESIGN:
  - Every user gets a default profile lazily ("Me") the first time profiles
    are listed, so existing accounts upgrade transparently.
  - Jobs created before profiles existed have profile_id NULL; the /reports
    endpoint attributes those to the default profile, preserving history.
  - Guests never hit these routes — their profiles live in localStorage.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth import get_current_user
from db.database import get_db
from db.models import Job, Medication, Profile, User

router = APIRouter(prefix="/api/v1/profiles", tags=["profiles"])

ALLOWED_RELATIONS = {"Self", "Mother", "Father", "Child", "Grandparent", "Sibling", "Partner", "Other"}


class ProfileRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    relation: str = Field("Other", max_length=40)


async def ensure_default_profile(user: User, db: AsyncSession) -> Profile:
    """Return the user's default profile, creating it on first access."""
    result = await db.execute(
        select(Profile).where(Profile.user_id == user.id).order_by(Profile.created_at)
    )
    profiles = result.scalars().all()
    if profiles:
        return next((p for p in profiles if p.is_default), profiles[0])

    first_name = (user.name or "Me").strip().split()[0]
    profile = Profile(user_id=user.id, name=first_name, relation="Self", is_default=1)
    db.add(profile)
    await db.commit()
    return profile


async def resolve_profile(user: User, profile_id: str | None, db: AsyncSession) -> Profile:
    """Map an optional client-supplied profile id to a verified Profile.
    Empty/unknown ids fall back to the default profile — never someone else's."""
    if profile_id:
        result = await db.execute(
            select(Profile).where(Profile.id == profile_id, Profile.user_id == user.id)
        )
        profile = result.scalar_one_or_none()
        if profile:
            return profile
    return await ensure_default_profile(user, db)


@router.get("")
async def list_profiles(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await ensure_default_profile(user, db)
    result = await db.execute(
        select(Profile).where(Profile.user_id == user.id).order_by(Profile.created_at)
    )
    return {"profiles": [p.to_dict() for p in result.scalars().all()]}


@router.post("", status_code=201)
async def create_profile(
    body: ProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    relation = body.relation if body.relation in ALLOWED_RELATIONS else "Other"
    profile = Profile(user_id=user.id, name=body.name.strip(), relation=relation)
    db.add(profile)
    await db.commit()
    return profile.to_dict()


@router.patch("/{profile_id}")
async def update_profile(
    profile_id: str,
    body: ProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Profile).where(Profile.id == profile_id, Profile.user_id == user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    profile.name = body.name.strip()
    if body.relation in ALLOWED_RELATIONS:
        profile.relation = body.relation
    await db.commit()
    return profile.to_dict()


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Profile).where(Profile.id == profile_id, Profile.user_id == user.id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    if profile.is_default:
        raise HTTPException(status_code=400, detail="The default profile can't be deleted.")

    # Fold the profile's reports back into the default profile (NULL means
    # default by convention) and drop its medication list.
    await db.execute(update(Job).where(Job.profile_id == profile_id).values(profile_id=None))
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(Medication).where(Medication.profile_id == profile_id))
    await db.delete(profile)
    await db.commit()
