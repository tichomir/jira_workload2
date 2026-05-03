import { JiraConnectFlow } from './components/JiraConnectFlow';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Jira Cloud Backup Connector</h1>
        <p className="mt-2 text-sm text-gray-500">
          Connect your Jira Cloud site to enable automated daily backups.
        </p>
      </div>

      <JiraConnectFlow />
    </div>
  );
}
