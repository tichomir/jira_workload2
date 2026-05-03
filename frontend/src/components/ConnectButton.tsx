import { initiateOAuth } from '../api/jira';

interface ConnectButtonProps {
  disabled?: boolean;
}

export function ConnectButton({ disabled = false }: ConnectButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={initiateOAuth}
      className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
    >
      {/* Jira-style cloud icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
      </svg>
      Connect Jira Cloud
    </button>
  );
}
