import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuditPage } from "./pages/Audit";
import { CompatibilityPage } from "./pages/Compatibility";
import { DeploymentPage } from "./pages/Deployment";
import { EnginesPage } from "./pages/Engines";
import { EngineVersionPage } from "./pages/EngineVersion";
import { FleetPage } from "./pages/Fleet";
import { LoginPage } from "./pages/Login";
import { ModelFamilyPage } from "./pages/ModelFamily";
import { ModelsPage } from "./pages/Models";
import { ModelVersionPage } from "./pages/ModelVersion";
import { OverviewPage } from "./pages/Overview";
import { RolloutPage } from "./pages/Rollout";
import { RolloutNewPage } from "./pages/RolloutNew";
import { RolloutsPage } from "./pages/Rollouts";
import { SimulatorPage } from "./pages/Simulator";
import { TargetPage } from "./pages/Target";
import { VulnerabilitiesPage } from "./pages/Vulnerabilities";
import { VulnerabilityPage } from "./pages/Vulnerability";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="models/:familyId" element={<ModelFamilyPage />} />
        <Route path="model-versions/:id" element={<ModelVersionPage />} />
        <Route path="engines" element={<EnginesPage />} />
        <Route path="engine-versions/:id" element={<EngineVersionPage />} />
        <Route path="compatibility" element={<CompatibilityPage />} />
        <Route path="fleet" element={<FleetPage />} />
        <Route path="fleet/deployments/:id" element={<DeploymentPage />} />
        <Route path="fleet/targets/:id" element={<TargetPage />} />
        <Route path="vulnerabilities" element={<VulnerabilitiesPage />} />
        <Route path="vulnerabilities/:id" element={<VulnerabilityPage />} />
        <Route path="rollouts" element={<RolloutsPage />} />
        <Route path="rollouts/new" element={<RolloutNewPage />} />
        <Route path="rollouts/:id" element={<RolloutPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="simulator" element={<SimulatorPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
