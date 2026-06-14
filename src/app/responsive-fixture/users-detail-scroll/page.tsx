import { notFound } from "next/navigation";
import { UserDetailFixtureClient } from "../users-detail/fixture-client";

/**
 * DEV-ONLY rendering fixture for verifying the UserHeroSticky scroll-collapse
 * bar against the SAME inner-scroll geometry the real admin shell uses.
 *
 * Unlike ../users-detail (which scrolls the window), this wraps the real
 * <UserViewModern> in a fixed-height `[data-admin-scroll]` `overflow-auto`
 * container — an exact reproduction of src/app/(admin)/layout.tsx's content
 * region. That is the environment in which the owner reported the condensed
 * bar never appearing: a viewport-rooted IntersectionObserver does not fire
 * for content that scrolls inside an inner overflow container.
 *
 * Renders the ACTUAL production component (imported, not reimplemented).
 * Returns 404 in production so it can never be reached by a real admin.
 */
export const dynamic = "force-dynamic";

export default function ResponsiveUserDetailScrollFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Mirror the admin shell: a flex-1 inner scroll container carrying
          data-admin-scroll, the exact selector UserHeroSticky falls back to. */}
      <div
        data-admin-scroll
        className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6"
      >
        <UserDetailFixtureClient />
        {/* Tall spacer so there is enough scroll room to push the hero fully
            past the top of the container — in production the user-detail page
            has many tabs of data below the hero; the static fixture is short,
            so without this the sentinel can never cross the container top. */}
        <div aria-hidden style={{ height: "1600px" }} />
      </div>
    </div>
  );
}
