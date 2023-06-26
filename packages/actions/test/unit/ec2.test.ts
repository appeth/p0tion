import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import { EC2Client } from "@aws-sdk/client-ec2"
import fetch from "@adobe/node-fetch-retry"
import { cleanUpMockUsers, cleanUpRecursively, createMockCeremony, createMockContribution, createMockParticipant, createMockUser, deleteBucket, deleteObjectFromS3, envType, generateUserPasswords, getStorageConfiguration, getTranscriptLocalFilePath, initializeAdminServices, initializeUserServices, sleep } from "../utils"
import {  
    checkEC2Status, 
    createEC2Client, 
    createEC2Instance, 
    createSSMClient, 
    getAWSVariables, 
    retrieveCommandOutput, 
    runCommandOnEC2, 
    startEC2Instance, 
    stopEC2Instance, 
    terminateEC2Instance 
} from "../../src/helpers/ec2"
import { P0tionEC2Instance } from "../../src/types"
import { fakeCeremoniesData, fakeCircuitsData, fakeUsersData } from "../data/samples"
import { getAuth, signInWithEmailAndPassword } from "firebase/auth"
import { SSMClient } from "@aws-sdk/client-ssm"
import { CeremonyState, ParticipantContributionStep, ParticipantStatus, TestingEnvironment, checkAndPrepareCoordinatorForFinalization, checkParticipantForCeremony, commonTerms, createCustomLoggerForFile, createS3Bucket, finalizeCeremony, finalizeCircuit, formatZkeyIndex, generateGetObjectPreSignedUrl, genesisZkeyIndex, getBucketName, getCeremonyCircuits, getCircuitBySequencePosition, getCircuitsCollectionPath, getDocumentById, getParticipantsCollectionPath, getPotStorageFilePath, getVerificationKeyStorageFilePath, getVerifierContractStorageFilePath, getZkeyStorageFilePath, multiPartUpload, permanentlyStoreCurrentContributionTimeAndHash, progressToNextCircuitForContribution, progressToNextContributionStep, setupCeremony, verifyContribution } from "../../src"
import { cwd } from "process"
import fs from "fs"
import { zKey } from "snarkjs"
import { randomBytes } from "crypto"
import { generateFakeParticipant } from "../data/generators"
chai.use(chaiAsPromised)

// @note AWS EC2 on demand VM tests
describe("VMs", () => {
    let instance: P0tionEC2Instance
    let ec2: EC2Client

    const { amiId, keyName, roleArn } = getAWSVariables() 

    beforeAll(async () => {
        ec2 = await createEC2Client()
    })

    describe("EC2", () => {
        it("should create an instance", async () => {
            instance = await createEC2Instance(ec2, [
                "echo 'hello world' > hello.txt",
                "aws s3 cp hello.txt s3://p0tion-test-bucket/hello.txt"
            ], "t2.micro", amiId, keyName, roleArn, 8)
            expect(instance).to.not.be.undefined
            // give it time to actually spin up 
            await sleep(250000)
        })

        it("checkEC2Status should return true for an instance that is running", async () => {
            const response = await checkEC2Status(ec2, instance.InstanceId!)
            expect(response).to.be.true 
        })  
    
        it("stopEC2Instance should stop an instance", async () => {
            await expect(stopEC2Instance(ec2, instance.InstanceId!)).to.be.fulfilled
            await sleep(200000)
        })
    
        it("checkEC2Status should throw for an instance that is stopped", async () => {
            await expect(checkEC2Status(ec2, instance.InstanceId!)).to.be.rejected
        })
    
        it("startEC2Instance should start an instance", async () => {
            await expect(startEC2Instance(ec2, instance.InstanceId!)).to.be.fulfilled
            await sleep(200000)
        })
    
        it("terminateEC2Instance should terminate an instance", async () => {
            await expect(terminateEC2Instance(ec2, instance.InstanceId!)).to.be.fulfilled
        })
    })

    describe("SSM", () => {
        let ssmClient: SSMClient 
        let commandId: string 
        let ssmTestInstance: P0tionEC2Instance
        beforeAll(async () => {
            ssmClient = await createSSMClient()
            const userData = [
                    "#!/bin/bash",
                    "aws s3 cp s3://p0tion-test-bucket/script_test.sh script_test.sh",
                    "chmod +x script_test.sh && bash script_test.sh"
            ]
            ssmTestInstance = await createEC2Instance(ec2, userData, "t2.small", amiId, keyName, roleArn, 8)
            await sleep(250000)
        })
        it("should run my commands", async () => {
            await runCommandOnEC2(ssmClient, ssmTestInstance.InstanceId, [
                `pwd`
            ] )
            
        })
        it("run a command on a VM that is active", async () => {
            commandId = await runCommandOnEC2(ssmClient, ssmTestInstance.InstanceId!, [
                "echo $(whoami)"
            ])
            expect(commandId).to.not.be.null 
            await sleep(500)
        })
        it("should throw when trying to call a command on a VM that is not active", async () => {
            await expect(runCommandOnEC2(ssmClient, "nonExistentOrOff", ["echo hello world"])).to.be.rejected
        })
        it("should retrieve the output of a command", async () => {
            await sleep(20000)
            const output = await retrieveCommandOutput(ssmClient, commandId, ssmTestInstance.InstanceId!)
            expect(output.length).to.be.gt(0)
        })
        it("should throw when trying to retrieve the output of a non existent command", async () => {
            await expect(retrieveCommandOutput(ssmClient, "nonExistentCommand", ssmTestInstance.InstanceId!)).to.be.rejected
        })
        afterAll(async () => {
            await terminateEC2Instance(ec2, ssmTestInstance.InstanceId!)
        })
    })

    afterAll(async () => {
        await terminateEC2Instance(ec2, instance.InstanceId!)
    })

    describe("Setup and run a ceremony using VMs", () => {
        // Sample data for running the test.
        const users = [fakeUsersData.fakeUser1, fakeUsersData.fakeUser2]
        const passwords = generateUserPasswords(2)

        // Initialize user and admin services.
        const { userApp, userFunctions, userFirestore } = initializeUserServices()
        const { adminFirestore, adminAuth } = initializeAdminServices()
        const userAuth = getAuth(userApp)

         // Get configs for storage.
        const { ceremonyBucketPostfix, streamChunkSizeInMb } = getStorageConfiguration()
        const ceremony = fakeCeremoniesData.fakeCeremonyOpenedFixed
        const ceremonyBucket = getBucketName(ceremony.data.prefix, ceremonyBucketPostfix)
        const circuit = fakeCircuitsData.fakeCircuitSmallNoContributors
        circuit.data.prefix = 'circuit'

        let ceremonyId: string 
        const instancesToTerminate: string[] = []

        const zkeyPath = `${cwd()}/packages/actions/test/data/artifacts/circuit_0000.zkey`
        const potPath = `${cwd()}/packages/actions/test/data/artifacts/powersOfTau28_hez_final_02.ptau`
        let storagePath = getZkeyStorageFilePath(
            circuit.data.prefix!,
            `${circuit.data.prefix}_${genesisZkeyIndex}.zkey`
        )
    
        const potStoragePath = getPotStorageFilePath(circuit.data.files?.potFilename!)
        const outputDirectory = `${cwd()}/packages/actions/test/data/artifacts/output`

        if (envType === TestingEnvironment.PRODUCTION) {
            // create dir structure
            fs.mkdirSync(`${outputDirectory}/contribute/attestation`, { recursive: true })
            fs.mkdirSync(`${outputDirectory}/contribute/transcripts`, { recursive: true })
            fs.mkdirSync(`${outputDirectory}/contribute/zkeys`, { recursive: true })

        }

        // the mock ceremony which will be used for finalization
        const ceremonyClosed = fakeCeremoniesData.fakeCeremonyClosedDynamic
        ceremonyClosed.data.prefix = ceremony.data.prefix

        // Filenames.
        const verificationKeyFilename = `${circuit?.data.prefix}_vkey.json`
        const verifierContractFilename = `${circuit?.data.prefix}_verifier.sol`

        // local paths of the vk and contract
        const verificationKeyLocalPath = `${cwd()}/packages/actions/test/data/artifacts/${
            circuit?.data.prefix
        }_vkey.json`
        const verifierContractLocalPath = `${cwd()}/packages/actions/test/data/artifacts/${
            circuit?.data.prefix
        }_verifier.sol`

        // Get storage paths.
        const verificationKeyStoragePath = getVerificationKeyStorageFilePath(
            circuit?.data.prefix!,
            verificationKeyFilename
        )
        const verifierContractStoragePath = getVerifierContractStorageFilePath(
            circuit?.data.prefix!,
            verifierContractFilename
        )

        // s3 objects we have to delete
        const objectsToDelete = [potStoragePath, storagePath]

        // ceremony for contribution
        const secondCeremonyId = ceremony.uid

        // a random contribution id for the contribution doc
        const contributionId = randomBytes(20).toString("hex")

        beforeAll(async () => {
            // create 2 users the second is the coordinator
            for (let i = 0; i < 2; i++) {
                users[i].uid = await createMockUser(
                    userApp,
                    users[i].data.email,
                    passwords[i],
                    i === passwords.length - 1,
                    adminAuth
                )
            }

            // create a bucket for the ceremony
            await signInWithEmailAndPassword(userAuth, users[1].data.email, passwords[1])
            await createS3Bucket(userFunctions, ceremonyBucket)

            // zkey upload
            await multiPartUpload(userFunctions, ceremonyBucket, storagePath, zkeyPath, streamChunkSizeInMb)
            // pot upload
            await multiPartUpload(userFunctions, ceremonyBucket, potStoragePath, potPath, streamChunkSizeInMb)
            // verification key upload
            await multiPartUpload(
                userFunctions,
                ceremonyBucket,
                verificationKeyStoragePath,
                verificationKeyLocalPath,
                streamChunkSizeInMb
            )
            // verifier contract upload
            await multiPartUpload(
                userFunctions,
                ceremonyBucket,
                verifierContractStoragePath,
                verifierContractLocalPath,
                streamChunkSizeInMb
            )

            // create mock ceremony with circuit data
            await createMockCeremony(adminFirestore, ceremony, circuit)

            // create ceremony closed 
            await createMockCeremony(adminFirestore, ceremonyClosed, circuit)

            // add coordinator final contribution
            const coordinatorParticipant = generateFakeParticipant({
                uid: users[1].uid,
                data: {
                    userId: users[1].uid,
                    contributionProgress: 1,
                    contributionStep: ParticipantContributionStep.COMPLETED,
                    status: ParticipantStatus.DONE,
                    contributions: [],
                    lastUpdated: Date.now(),
                    contributionStartedAt: Date.now() - 100,
                    verificationStartedAt: Date.now(),
                    tempContributionData: {
                        contributionComputationTime: Date.now() - 100,
                        uploadId: "001",
                        chunks: []
                    }
                }
            })
            await createMockParticipant(
                adminFirestore,
                fakeCeremoniesData.fakeCeremonyClosedDynamic.uid,
                users[1].uid,
                coordinatorParticipant
            )

            // add a contribution
            const finalContribution = {
                participantId: users[1].uid,
                contributionComputationTime: new Date().valueOf(),
                verificationComputationTime: new Date().valueOf(),
                zkeyIndex: `final`,
                files: {},
                lastUpdate: new Date().valueOf()
            }
            await createMockContribution(
                adminFirestore,
                ceremonyClosed.uid,
                circuit.uid,
                finalContribution,
                contributionId
            )
        })

        afterAll(async () => {
            // terminate the instances created in the previous tests 
            // just in case the finalization test did not work 
            for (const instanceId of instancesToTerminate) {
                try {
                    await terminateEC2Instance(ec2, instanceId)
                } catch (error: any) {}
            }

            // delete objects from s3 and bucket
            for (const objectToDelete of objectsToDelete) {
                await deleteObjectFromS3(ceremonyBucket, objectToDelete)
            }
            await deleteBucket(ceremonyBucket)

            // delete users and mock ceremonies
            await cleanUpMockUsers(adminAuth, adminFirestore, users)
            await cleanUpRecursively(adminFirestore, ceremonyId)
            await cleanUpRecursively(adminFirestore, secondCeremonyId)
            await cleanUpRecursively(adminFirestore, ceremonyClosed.uid)

            // remove local files
            fs.rmdirSync(`${outputDirectory}`, { recursive: true })
        })

        // @note this test sets up a new ceremony and confirms whether the VM(s) are created
        it("should create a ceremony and the VM should spin up", async () => {
            // 1. setup ceremony
            ceremonyId = await setupCeremony(userFunctions, ceremony.data, ceremony.data.prefix!, [circuit.data])

            // 2. confirm
            const ceremonyDoc = await getDocumentById(
                userFirestore,
                commonTerms.collections.ceremonies.name,
                ceremonyId
            )

            const circuits = await getCeremonyCircuits(userFirestore, ceremonyDoc.id)
            
            for (const circuit of circuits) {
                const { vmInstanceId } = circuit.data
                expect(vmInstanceId).to.not.be.null
                instancesToTerminate.push(vmInstanceId)
            }
        })

        // @note should run after the first one
        // this test performs a contribution and confirms that the verification 
        // is successful as expected
        it("should verify a contribution", async () => {
            // 1. login
            await signInWithEmailAndPassword(userAuth, users[0].data.email, passwords[0])
            await sleep(500)
            // 2. get circuits for ceremony
            const circuits = await getCeremonyCircuits(userFirestore, secondCeremonyId)
            expect(circuits.length).to.be.gt(0)


            // set the VM instance ID that we setup before
            for (const circuit of circuits) {
                await adminFirestore.collection(getCircuitsCollectionPath(secondCeremonyId)).doc(circuit.id).set({
                    ...circuit.data,
                    vmInstanceId: instancesToTerminate[circuits.indexOf(circuit)]
                })
            }

            // 3. register for cermeony
            const canParticipate = await checkParticipantForCeremony(userFunctions, secondCeremonyId)
            expect(canParticipate).to.be.true

            // 4. entropy
            const entropy = randomBytes(32).toString("hex")

            // 5. get circuit to contribute to
            const circuit = getCircuitBySequencePosition(circuits, 1)
            expect(circuit).not.be.null

            // 6. get circuit data
            const currentProgress = circuit.data.waitingQueue.completedContributions
            const currentZkeyIndex = formatZkeyIndex(currentProgress)
            const nextZkeyIndex = formatZkeyIndex(currentProgress + 1)

            // 7. download previous contribution
            storagePath = getZkeyStorageFilePath(circuit.data.prefix, `${circuit.data.prefix}_${currentZkeyIndex}.zkey`)

            const lastZkeyLocalFilePath = `${outputDirectory}/contribute/zkeys/${circuit.data.prefix}_${currentZkeyIndex}.zkey`
            const nextZkeyLocalFilePath = `${outputDirectory}/contribute/zkeys/${circuit.data.prefix}_${nextZkeyIndex}.zkey`

            const preSignedUrl = await generateGetObjectPreSignedUrl(userFunctions, ceremonyBucket, storagePath)
            // @ts-ignore
            const getResponse = await fetch(preSignedUrl)
            await sleep(500)
            // Write the file to disk.
            fs.writeFileSync(lastZkeyLocalFilePath, await getResponse.buffer())
            await sleep(500)
            // 9. progress to next step
            await progressToNextCircuitForContribution(userFunctions, secondCeremonyId)
            await sleep(1000)

            const transcriptLocalFilePath = `${outputDirectory}/${getTranscriptLocalFilePath(
                `${circuit.data.prefix}_${nextZkeyIndex}.log`
            )}`
            const transcriptLogger = createCustomLoggerForFile(transcriptLocalFilePath)
            // 10. do contribution
            await zKey.contribute(lastZkeyLocalFilePath, nextZkeyLocalFilePath, users[0].uid, entropy, transcriptLogger)
            await sleep(1000)

            // read the contribution hash
            const transcriptContents = fs.readFileSync(transcriptLocalFilePath, "utf-8").toString()
            const matchContributionHash = transcriptContents.match(/Contribution.+Hash.+\n\t\t.+\n\t\t.+\n.+\n\t\t.+\n/)
            const contributionHash = matchContributionHash?.at(0)?.replace("\n\t\t", "")!

            await progressToNextContributionStep(userFunctions, secondCeremonyId)
            await sleep(2000)
            await permanentlyStoreCurrentContributionTimeAndHash(
                userFunctions,
                secondCeremonyId,
                new Date().valueOf(),
                contributionHash
            )
            await sleep(2000)

            await progressToNextContributionStep(userFunctions, secondCeremonyId)
            await sleep(1000)

            const participant = await getDocumentById(
                userFirestore,
                getParticipantsCollectionPath(secondCeremonyId),
                users[0].uid
            )

            // Upload
            const nextZkeyStoragePath = getZkeyStorageFilePath(
                circuit.data.prefix,
                `${circuit.data.prefix}_${nextZkeyIndex}.zkey`
            )
            await multiPartUpload(
                userFunctions,
                ceremonyBucket,
                nextZkeyStoragePath,
                nextZkeyLocalFilePath,
                streamChunkSizeInMb,
                secondCeremonyId,
                participant.data()!.tempContributionData
            )
            await sleep(1000)

            objectsToDelete.push(nextZkeyStoragePath)

            // Execute contribution verification.
            const tempCircuit = await getDocumentById(
                userFirestore,
                getCircuitsCollectionPath(secondCeremonyId),
                circuit.id
            )

            await verifyContribution(
                userFunctions,
                secondCeremonyId,
                tempCircuit,
                ceremonyBucket,
                users[0].uid,
                String(process.env.FIREBASE_CF_URL_VERIFY_CONTRIBUTION)
            )
        })

        // @note this test will terminate a ceremony 
        // and confirm whether the VMs were terminated
        it("should terminate the VM(s) when finalizing the ceremony", async () => {
            const circuits = await getCeremonyCircuits(userFirestore, ceremonyClosed.uid)
            // set the VM instance ID that we setup before
            for (const circuit of circuits) {
                await adminFirestore.collection(getCircuitsCollectionPath(ceremonyClosed.uid)).doc(circuit.id).set({
                    ...circuit.data,
                    vmInstanceId: instancesToTerminate[circuits.indexOf(circuit)]
                })
            }
            const result = await checkAndPrepareCoordinatorForFinalization(userFunctions, ceremonyClosed.uid)
            expect(result).to.be.true
            // call the function
            await expect(
                finalizeCircuit(userFunctions, ceremonyClosed.uid, circuit.uid, ceremonyBucket, `handle-id`)
            ).to.be.fulfilled

            await expect(finalizeCeremony(userFunctions, ceremonyClosed.uid)).to.be.fulfilled

            const ceremony = await getDocumentById(
                userFirestore,
                commonTerms.collections.ceremonies.name,
                ceremonyClosed.uid
            )
            const ceremonyData = ceremony.data()
            expect(ceremonyData?.state).to.be.eq(CeremonyState.FINALIZED)

            const coordinatorDoc = await getDocumentById(
                userFirestore,
                getParticipantsCollectionPath(ceremonyClosed.uid),
                users[1].uid
            )
            const coordinatorData = coordinatorDoc.data()
            expect(coordinatorData?.status).to.be.eq(ParticipantStatus.FINALIZED)

            // now we wait and check that the VMs are terminated
            await sleep(10000)

            // the call to checkEC2 status should fail
            for (const instanceId of instancesToTerminate) await expect(checkEC2Status(ec2, instanceId)).to.be.rejected
        })
    })
})
