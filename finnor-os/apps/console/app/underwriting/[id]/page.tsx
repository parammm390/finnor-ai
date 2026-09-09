import UnderwritingWorkspaceClient from "../../../components/underwriting/WorkspaceClient";

export default async function UnderwritingWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UnderwritingWorkspaceClient investmentCaseId={id} />;
}
