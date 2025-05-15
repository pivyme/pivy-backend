// Auth middlweare reading token
import jwt from 'jsonwebtoken';
import { prismaQuery } from '../lib/prisma.js';

export const authMiddleware = async (request, reply) => {
  try {
    const token = request.headers.authorization.split(' ')[1];
    // console.log('Token:', token);
  
    let authData = null;
    try {
      authData = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      console.log(`Token verification failed with error ${error}.`);
      return reply.code(401).send({
        error: 'Invalid token'
      });
    }
  
    const user = await prismaQuery.user.findUnique({
      where: {
        id: authData.id
      }
    })
  
    if (!user) {
      reply.code(401).send({
        error: 'Unauthorized'
      });
      return false;
    }
  
    request.user = user;
    return true;
  } catch (error) {
    console.log('Error in authMiddleware', error);
    return false;
  }
}