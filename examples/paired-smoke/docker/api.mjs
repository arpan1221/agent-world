import { createServer } from 'node:http';
import { handler } from '../backend/handler.mjs';
createServer(handler).listen(3001, '0.0.0.0');
