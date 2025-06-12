import type { Response } from 'express';

export class User {

    isMatched: boolean = false;


    userId: string;
    interest: string = "COLLEGE";
    responseObject: Response;

    constructor(userId: string, interest: string, response: Response) {
        this.userId = userId;
        this.responseObject = response;
        this.interest = interest || "COLLEGE"; // Default interest if not provided
    }
}
