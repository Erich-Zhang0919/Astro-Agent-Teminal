#!/usr/bin/env node
import './env'
import { buildProgram } from './command'

buildProgram().parseAsync(process.argv)
