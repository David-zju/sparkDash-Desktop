/** Compute a complete cluster update before the registry performs one atomic write. */
export function planClusterUpdate(sparks, { name, headId, memberIds, previousHeadId = null }, dissolve = false) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  const byId = new Map(sparks.map((s) => [s.id, s]));
  if (previousHeadId != null && byId.get(previousHeadId)?.role !== "head") fail("The original cluster no longer exists. Reopen cluster setup.");
  const oldMembers = new Set(previousHeadId ? sparks.filter((s) => s.id === previousHeadId || (s.role === "worker" && s.workerHeadId === previousHeadId)).map((s) => s.id) : []);
  if (!dissolve) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) fail("Cluster name must contain 1–80 characters");
    if (!Array.isArray(memberIds) || memberIds.length < 2 || memberIds.length > 12 || new Set(memberIds).size !== memberIds.length) fail("Select 2–12 distinct cluster members");
    if (!memberIds.includes(headId)) fail("Choose a Head from the cluster members");
    for (const id of memberIds) {
      const spark = byId.get(id);
      if (!spark) fail("A selected device no longer exists. Reopen cluster setup.");
      if (spark.kind === "host") fail("Cluster setup currently supports DGX Spark devices");
      if (!oldMembers.has(id) && (spark.role === "head" || (spark.role === "worker" && spark.workerHeadId && byId.get(spark.workerHeadId)?.role === "head"))) {
        fail("A selected device already belongs to another cluster");
      }
    }
  }
  const selected = new Set(dissolve ? [] : memberIds);
  return sparks.map((spark) => {
    if (selected.has(spark.id)) return { ...spark, role: spark.id === headId ? "head" : "worker",
      workerNode: spark.id !== headId, workerHeadId: spark.id === headId ? null : headId,
      clusterName: spark.id === headId ? name.trim() : null, llmMonitoring: spark.id === headId };
    if (oldMembers.has(spark.id)) return { ...spark, role: "standalone", workerNode: false,
      workerHeadId: null, workerLabel: null, clusterName: null, llmMonitoring: true };
    return spark;
  });
}
