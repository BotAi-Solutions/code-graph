# typescript-sample

A deliberately small, layered TypeScript application used as the fixture for the
end-to-end analysis pipeline.

```
controllers/user.controller.ts   UserController extends BaseController
        | CALLS
services/user.service.ts         UserService
        | CALLS
repositories/user.repository.ts  UserRepository implements UserStore
        | REFERENCES
models/user.ts                   User, UserDraft, UserRole, createUser, isAdmin
```

`utils/logger.ts` is referenced from every layer, which makes it a useful
high-degree node when checking the graph overview.

It has no dependencies and is never installed: the pipeline indexes it in place.
