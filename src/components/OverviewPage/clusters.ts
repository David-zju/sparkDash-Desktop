import type { FabricDiscovery, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";

export function clusterGroups(sparks: SparkSnapshot[]) {
  return sparks.filter((s) => resolveSparkRole(s) === "head").map((head) => ({
    head, name: head.clusterName || `${head.name} Cluster`,
    members: [head, ...sparks.filter((s) => resolveSparkRole(s) === "worker" && s.workerHeadId === head.id)],
  }));
}

/** Connected components suggest membership; every pair is still shown for review. */
export function fabricCandidates(result: FabricDiscovery) {
  const remaining = new Set(result.nodes.filter((n) => !n.error).map((n) => n.id));
  const groups: string[][] = [];
  while (remaining.size) {
    const group = [remaining.values().next().value!];
    remaining.delete(group[0]);
    for (let i = 0; i < group.length; i++) {
      for (const link of result.links.filter((l) => l.verified200G && (l.a === group[i] || l.b === group[i]))) {
        const peer = link.a === group[i] ? link.b : link.a;
        if (remaining.delete(peer)) group.push(peer);
      }
    }
    if (group.length >= 2) groups.push(group);
  }
  return groups;
}

export function hasVerifiedFabric(result: FabricDiscovery | null, ids: string[]) {
  if (!result || ids.length < 2) return false;
  return ids.every((a, i) => ids.slice(i + 1).every((b) => result.links.some((l) =>
    ((l.a === a && l.b === b) || (l.a === b && l.b === a)) && l.verified200G
  )));
}
