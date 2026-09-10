import IcWorkspaceClient from "../../../components/ic/IcWorkspaceClient";

export default async function IcWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IcWorkspaceClient icCaseId={id} />;
}
