# The OR3 Net + OR3 Node Story

## The short version

Imagine you run a control tower for computers.

- **`or3-net`** is the control tower.
- **`or3-node`** is the helper that lives on each real computer.

The control tower decides **who is allowed**, **what work should happen**, and **which machine should do it**.
The helper on the computer actually **runs the command**, **reads the file**, **opens the terminal**, or **starts the service**.

That split matters because it keeps the web server and the real machine as two different jobs:

- the control plane stays focused on trust, approval, scheduling, and APIs
- the node agent stays focused on safely doing work on one actual computer

In plain English: **OR3 Node exists so OR3 Net can control real computers without turning the control plane itself into a machine daemon.**

---

## Why this project needs to exist

If `or3-net` tried to directly live inside every machine it controlled, it would become much harder to install, update, secure, and reason about.

Instead, the project uses a two-part model:

1. **A central brain** (`or3-net`)
   - keeps the source of truth
   - knows the users, workspaces, approvals, jobs, runtime sessions, and browser-facing access
   - decides whether a machine is allowed to do work

2. **A local pair of hands** (`or3-node`)
   - runs on the target machine
   - proves which machine it is
   - calls home to the control plane
   - performs machine-local actions

This is especially useful when the target machine is behind a firewall or home router.
Instead of the server trying to break in, the agent makes an **outbound connection** back to the control plane.
That is usually much easier and safer.

---

## The story of a machine joining OR3

### Chapter 1: The machine gets its own identity

The first time `or3-node` runs, it creates a unique cryptographic identity.
You can think of this like giving the machine its own passport.

That identity is stored locally and should stay stable unless you intentionally reset it.
Why?
Because if the machine changed identity every time it restarted, the control plane would no longer know whether it was talking to the same computer as before.

In the codebase, this is handled in the identity and storage pieces.
The identity is saved on disk so the machine can keep proving “I am still me.”

---

### Chapter 2: The machine asks permission to join

A fresh machine is not trusted automatically.
It uses a **bootstrap token**, which is like a short-lived invitation code.

The machine sends that token, along with a signed description of itself, to `or3-net`.
That description is called a **manifest**.

A manifest is basically a facts sheet:

- who the machine says it is
- what version it is running
- what features it supports
- what limits it has

This step is important because the control plane should not give a long-lived machine a giant all-powerful workspace token.
Instead, it uses a narrow onboarding token first.

---

### Chapter 3: A human or trusted workflow approves the machine

After enrollment, the machine is usually still in a **pending** state.
That means OR3 knows the machine exists, but has not trusted it yet.

Approval is the trust gate.
Once approved, the control plane can hand the machine a runtime credential that is meant for normal ongoing use.

That gives the project a clean trust model:

- bootstrap token = get in the door once
- runtime credential = do your normal day-to-day work after approval

---

### Chapter 4: The machine phones home and stays connected

After approval, `or3-node` connects back to `or3-net` over a long-lived connection, usually WebSocket-based.

Think of this like a walkie-talkie that stays open:

- the machine can say “I’m still here” using heartbeats
- the control plane can send work quickly
- both sides can notice disconnects
- interactive features such as terminal sessions become possible later

This connection is one of the most important parts of the architecture.
It lets machines behind NAT, firewalls, or home internet setups stay controllable without needing incoming open ports.

---

## What the control plane actually sends

Once the machine is connected, `or3-net` can send requests such as:

- run a command
- stop a command
- create a session
- fetch logs
- read or write files
- open or close a terminal-like PTY session
- launch or stop a service

The current codebase already has many of these shapes in the transport loop.
That means the system is moving beyond “just run one command” and toward “control a real computer using the same OR3 model.”

---

## What a runtime session means in simple terms

A **runtime session** is just a named period of work with continuity.

Instead of saying “run this one command and forget everything,” a session lets OR3 keep some shared context around a machine interaction.
That is helpful for:

- a sequence of commands
- collecting logs
- keeping a working directory or process context alive
- later supporting richer interactive computer control

So if a normal job is like asking someone to do one chore, a runtime session is like opening a work ticket that can contain several related chores.

---

## What a PTY is, in normal language

A **PTY** is the software version of a terminal window.
If you have ever used a command prompt, shell, or terminal, that is the idea.

Why would OR3 need this?
Because some kinds of remote control are not just “run one command and wait.”
Sometimes you want a more interactive experience:

- type input
- resize the terminal
- see output as it appears
- close it cleanly

That is why the planning docs treat PTY as an optional capability, not an assumption.
Some platforms can support it better than others.

---

## Why the project talks so much about capabilities

Not every computer can or should do everything.
Some machines may support:

- command execution
- reading files
- writing files
- PTY sessions
- launching browser-facing services

Other machines may only support a safe subset.

So the system uses **capabilities** as a way for each machine to honestly describe what it can do.
This helps the control plane avoid bad assumptions.
It is better to say “this machine does not support PTY” than to pretend it does and fail later.

---

## Why the project also talks so much about limits

This agent runs on a real computer, so it has to behave carefully.
That is why the design keeps mentioning limits such as:

- timeouts
- maximum output size
- maximum stdin size
- allowed directories
- allowed environment variables
- concurrency caps

Without those boundaries, a simple remote execution feature could become a resource or security problem.

The design is very clear about something important:
**this is trusted-machine control, not hostile-code isolation.**

That means the goal is not “run dangerous untrusted code from strangers with perfect isolation.”
The goal is “control a machine you trust, with explicit limits and predictable behavior.”

---

## A simple picture of the architecture

Here is the project in everyday language:

1. A person installs `or3-node` on a machine.
2. The machine creates an identity.
3. The machine enrolls into `or3-net` with a short-lived bootstrap token.
4. `or3-net` stores the machine as pending.
5. Someone approves it.
6. `or3-net` gives it a runtime credential.
7. The machine opens an outbound live connection back to the control plane.
8. `or3-net` sends jobs or runtime-session requests through that connection.
9. `or3-node` performs the local work and streams results back.
10. OR3 shows the outcome to the user through its existing APIs and UI.

That is the heart of the whole system.

---

## What the current `or3-node` codebase already has

Today’s repository already includes a lot of the building blocks:

- a CLI with `launch`, `doctor`, `info`, `status`, and `reset`
- local config and state storage
- persistent machine identity
- bootstrap redemption and manifest signing
- a transport loop for requests and responses
- host control for command execution
- file operations
- PTY support
- service management hooks
- tests for the CLI, transport loop, host control, and storage behavior

So this is not just a vague idea anymore.
It is already a real agent project with many of the core pieces in place.

---

## Where the current implementation still feels unfinished

The planning docs in `or3-net` describe a very strong “one main command” experience:

```bash
bun install -g or3-node
or3-node launch
```

That is clearly the north star.

But the current implementation still has a few obvious gaps between the plan and the present code:

- `launch` still reports that the agent loop is not started yet
- `--foreground` exists but does not yet visibly change behavior
- structured logging exists but is not yet deeply wired into the main flows
- operator diagnostics are still lighter than the planning docs want
- some truthfulness gaps remain, like the hard-coded version string

That is normal for a project mid-flight.
The important part is that the architecture is coherent: the unfinished work mostly looks like completing the intended path, not reinventing the whole system.

---

## The beginner-friendly mental model

If you only remember one idea, remember this:

**OR3 Net is the decision-maker. OR3 Node is the doer.**

- OR3 Net decides if the machine is trusted, what it is allowed to do, and what work should be sent.
- OR3 Node is the installed agent that safely carries out that work on the real computer.

That separation is what makes the whole project understandable.
It is also what keeps the system flexible:

- the control plane can stay stable
- the machine agent can grow richer capabilities over time
- users get a consistent OR3 experience whether work runs in a sandbox, a runtime session, or a real installed machine

---

## Why this is a smart architecture choice

This project exists because real computers are messy.
They can sit behind routers, have different operating systems, expose different capabilities, and go offline unexpectedly.

The OR3 architecture handles that by:

- keeping trust and scheduling centralized
- keeping machine-specific work local
- using signed identity and approval gates
- using an outbound connection model
- advertising capabilities explicitly
- enforcing limits near the machine itself

That is why the project is worth building.
It gives OR3 a way to control real machines using the same high-level control-plane model, without collapsing everything into one giant confusing service.

---

## Final takeaway

If OR3 were a movie:

- `or3-net` would be mission control
- `or3-node` would be the field agent on the ground

Mission control decides.
The field agent acts.
Both need each other.

And the whole reason `or3-node` exists is to let OR3 control real machines in a simple, safe, inspectable way.
