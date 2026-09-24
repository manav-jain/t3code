import { THREAD_GROUP_NAME_MAX_LENGTH } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly title: string;
  readonly confirmLabel: string;
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Ask for a thread group name. Resolves the trimmed name, or null when cancelled. */
export function requestThreadGroupName(input: {
  readonly title: string;
  readonly confirmLabel: string;
  readonly initialName?: string;
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { initialName: "", ...input, resolve } }),
  );
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function ThreadGroupDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ThreadGroupDialog request={request} /> : null;
}

function ThreadGroupDialog({ request }: { readonly request: Request }) {
  const id = useId();
  const [name, setName] = useState(request.initialName);
  const trimmed = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length > 0) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex flex-col items-stretch" htmlFor={id}>
              Group name
              <Input
                id={id}
                autoFocus
                placeholder="Work"
                maxLength={THREAD_GROUP_NAME_MAX_LENGTH}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Label>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {request.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
