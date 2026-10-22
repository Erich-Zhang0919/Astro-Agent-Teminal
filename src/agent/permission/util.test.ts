import * as fs from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { isInProjectDir } from './util'
import { decideWritePermission } from './write'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('node:path', () => ({ __esModule: true, ...jest.requireActual('node:path') }))

describe('isInProjectDir', () => {
    let root: string
    let project: string
    let home: string
    let astro: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(process.cwd(), '.astro-permission-'))
        project = path.join(root, 'project')
        home = path.join(root, 'home')
        astro = path.join(home, '.astro')
        fs.mkdirSync(project)
        fs.mkdirSync(astro, { recursive: true })
        jest.mocked(homedir).mockReturnValue(home)
    })

    afterEach(() => {
        jest.restoreAllMocks()
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('allows the project and user Astro directory, including new nested files', () => {
        for (const candidate of [project, 'new.txt', astro, path.join(astro, '.data', 'new.db'),
            path.relative(project, path.join(astro, 'astro.json'))]) {
            expect(isInProjectDir(candidate, project)).toBe(true)
        }
        expect(decideWritePermission({ file_path: path.join(astro, 'astro.json') }, project))
            .toEqual({ kind: 'allow' })
    })

    it('allows creating the Astro directory before it exists', () => {
        fs.rmdirSync(astro)
        expect(isInProjectDir(astro, project)).toBe(true)
        expect(isInProjectDir(path.join(astro, '.data', 'new.db'), project)).toBe(true)
    })

    it('rejects parent directories, similarly named siblings and traversal outside Astro', () => {
        for (const candidate of [home, path.join(home, 'other.txt'), `${astro}-backup/file`,
            `${project}-other/file`, path.join(astro, '..', 'other.txt')]) {
            expect(isInProjectDir(candidate, project)).toBe(false)
        }
    })

    it('rejects symlink escapes from either allowed directory', () => {
        const outside = path.join(root, 'outside')
        fs.mkdirSync(outside)
        for (const directory of [project, astro]) {
            const link = path.join(directory, 'escape')
            fs.symlinkSync(outside, link, 'junction')
            expect(isInProjectDir(path.join(link, 'new.txt'), project)).toBe(false)
        }
    })

    it('accepts an Astro directory reached through a symlink', () => {
        const target = path.join(root, 'astro-storage')
        fs.mkdirSync(target)
        fs.rmdirSync(astro)
        fs.symlinkSync(target, astro, 'junction')
        expect(isInProjectDir(path.join(astro, 'new.txt'), project)).toBe(true)
    })

    it('fails closed when the filesystem cannot resolve a path', () => {
        jest.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
            throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
        })
        expect(isInProjectDir(path.join(astro, 'new.txt'), project)).toBe(false)
    })
})

describe.each([
    ['macOS', path.posix, '/Users/test user', '/work/project'],
    ['Linux', path.posix, '/home/test user', '/work/project'],
    ['Windows', path.win32, 'C:\\Users\\test user', 'D:\\work\\project'],
] as const)('%s path semantics', (_platform, paths, home, project) => {
    beforeEach(() => {
        jest.mocked(homedir).mockReturnValue(home)
        jest.spyOn(path, 'resolve').mockImplementation(paths.resolve)
        jest.spyOn(path, 'join').mockImplementation(paths.join)
        jest.spyOn(path, 'relative').mockImplementation(paths.relative)
        jest.spyOn(path, 'isAbsolute').mockImplementation(paths.isAbsolute)
        jest.replaceProperty(path, 'sep', paths.sep)
        jest.spyOn(fs.realpathSync, 'native').mockImplementation(value => String(value))
    })

    afterEach(() => jest.restoreAllMocks())

    it('recognizes native home paths while excluding siblings and other drives', () => {
        const astro = paths.join(home, '.astro')
        expect(isInProjectDir(astro, project)).toBe(true)
        expect(isInProjectDir(paths.join(astro, 'astro.json'), project)).toBe(true)
        expect(isInProjectDir(paths.join(astro, '.data', 'new.db'), project)).toBe(true)
        expect(isInProjectDir(paths.join(home, '.astro-backup', 'file'), project)).toBe(false)
        expect(isInProjectDir(paths.join(astro, '..', 'file'), project)).toBe(false)
        expect(isInProjectDir(paths.join(astro, '..', '.astro-backup', 'file'), project)).toBe(false)
        expect(isInProjectDir(paths.join(project, 'new.txt'), project)).toBe(true)
    })
})
