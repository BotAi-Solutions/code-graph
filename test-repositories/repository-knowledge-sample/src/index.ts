import express from 'express';
import { Pool } from 'pg';
import { UserController } from './controllers/user.controller.js';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { createUserRouter } from './routes/user.routes.js';
import { AuthService } from './services/auth.service.js';
import { UserService } from './services/user.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? '' });

const users = new UserRepository(pool);
const sessions = new SessionRepository(pool);

const userService = new UserService(users);
const authService = new AuthService(sessions);

const app = express();
app.use('/', createUserRouter(new UserController(userService)));

export { app, authService };
