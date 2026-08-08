import React from "react";
import { LocusLogo } from "../landing-page/components/LocusLogo";


type StepStatus = "complete" | "in-progress" | "pending";

interface DecisionStep {
  label: string;
  status: StepStatus;
}

interface DecisionReadyProps {
  userEmail?: string;
  steps?: DecisionStep[];
  onGoToDashboard?: () => void;
  onOpenSettings?: () => void;
}

const LocusLogoMark: React.FC = () => (
  <div className="flex justify-center">
    <LocusLogo size={32} />
  </div>
);

const GoogleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4">
    <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.92l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09C3.24 21.3 7.28 24 12 24z" />
    <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.64H1.26a12 12 0 0 0 0 10.72l4.01-3.09z" />
    <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.24 2.7 1.26 6.64l4.01 3.09C6.22 6.88 8.87 4.77 12 4.77z" />
  </svg>
);

const CheckIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
    <path d="M5 13l4 4L19 7" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SpinnerIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3 animate-spin">
    <circle cx="12" cy="12" r="9" stroke="white" strokeWidth={3} strokeLinecap="round" strokeDasharray="14 40" />
  </svg>
);

interface StepRowProps {
  step: DecisionStep;
  isLast: boolean;
}

const StepRow: React.FC<StepRowProps> = ({ step, isLast }) => {
  const bubbleClasses = step.status === "pending" ? "bg-gray-200" : "bg-gray-900";
  return (
    <div className="flex items-start">
      <div className="flex flex-col items-center">
        <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${bubbleClasses}`}>
          {step.status === "complete" && <CheckIcon />}
          {step.status === "in-progress" && <SpinnerIcon />}
        </div>
        {!isLast && <div className="my-1 h-8 w-px bg-lime-400" />}
      </div>
      <p className={`ml-3 mt-0.5 text-sm ${step.status === "pending" ? "text-gray-400" : "text-gray-900"} ${step.label === "Done" ? "font-semibold" : ""}`}>
        {step.label}
      </p>
    </div>
  );
};

const defaultSteps: DecisionStep[] = [
  { label: "Pulling your recent messages and pages", status: "complete" },
  { label: "Classifying context into memory records", status: "complete" },
  { label: "Done", status: "complete" },
];

const DecisionReady: React.FC<DecisionReadyProps> = ({
  userEmail = "youremail@gmail.com",
  steps = defaultSteps,
  onGoToDashboard,
  onOpenSettings,
}) => {
  const handleGoToDashboard = () => {
    if (onGoToDashboard) {
      onGoToDashboard();
      return;
    }
    console.log("Go to Dashboard clicked");
  };

  const handleOpenSettings = () => {
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    console.log("Settings clicked");
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gray-50 px-6 py-16">
      <div className="w-full max-w-md text-center">
        <LocusLogoMark />
        <h1 className="mt-10 text-2xl font-bold text-gray-900 sm:text-3xl">
          Getting your memory ready
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-gray-500">
          This usually takes under a minute. Feel free to wait, or head to your
          dashboard now — we'll keep going in the background.
        </p>
        <div className="mt-3 flex items-center justify-center gap-1.5 text-sm text-gray-600">
          <GoogleIcon />
          Signed in as <span className="font-semibold text-gray-900">{userEmail}</span>
        </div>
        <div className="mx-auto mt-12 flex max-w-xs flex-col items-start text-left">
          {steps.map((step, i) => (
            <StepRow key={step.label} step={step} isLast={i === steps.length - 1} />
          ))}
        </div>
        <button
          type="button"
          onClick={handleGoToDashboard}
          className="mt-12 w-full rounded-full bg-indigo-600 px-6 py-3 font-semibold text-white transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          Go to Dashboard
        </button>
        <p className="mt-4 text-xs text-gray-400">
          You can connect or disconnect tools anytime from{" "}
          <button type="button" onClick={handleOpenSettings} className="font-medium text-indigo-600 hover:underline">
            Settings
          </button>
        </p>
      </div>
    </div>
  );
};

export default DecisionReady;