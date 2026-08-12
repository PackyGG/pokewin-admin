import { notFound } from "next/navigation";
import { UserDetailFixtureClient } from "../responsive-fixture/users-detail/fixture-client";

export const dynamic = "force-dynamic";

/**
 * Development-only, authentication-free preview of the real user-detail
 * Account tab. This renders the production component tree with fixture data;
 * it is not a visual reimplementation.
 */
export default function AccountTabPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="min-w-0 p-3 sm:p-4 md:p-6">
        <UserDetailFixtureClient initialTab="account" />
      </div>
    </div>
  );
}
